using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class AddCarePackSourceInvoiceNumber : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "SourceInvoiceNumber",
                table: "CarePackBatches",
                type: "nvarchar(50)",
                maxLength: 50,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "SourceInvoiceNumber",
                table: "CarePackBatches");
        }
    }
}
